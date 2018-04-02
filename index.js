const path = require('path')
const fastCgi = require('fastcgi-client')
const {HTTPParser} = require('http-parser-js')
const defaultOptions = {
  host: '127.0.0.1',
  port: 9000,
  documentRoot: path.dirname(require.main.filename || '.'),
  skipCheckServer: true
}

module.exports = function(userOptions = {}, customParams = {}) {
  const options = Object.assign({}, defaultOptions, userOptions)
  const fpm = new Promise((resolve, reject) => {
    const loader = fastCgi(options)
    loader.on('ready', () => resolve(loader))
    loader.on('error', reject)
  })

  return async function(req, res) {
    let params = Object.assign({}, customParams, {
      uri: req.url
    })

    if (!params.uri || !params.uri.startsWith('/')) {
      throw new Error('invalid uri')
    }

    if (options.rewrite) {
      const rules = Array.isArray(options.rewrite)
        ? options.rewrite
        : [options.rewrite]
      for (const rule of rules) {
        const match = params.uri.match(rule.search || /.*/)
        if (match) {
          let result = rule.replace
          for (const index in match) {
            const selector = new RegExp(`\\$${index}`, 'g')
            result = result.replace(selector, match[index])
          }
          params.outerUri = params.uri
          params.uri = result
          break
        }
      }
    }

    if (params.uri.indexOf('?') !== -1) {
      params.document = params.uri.split('?')[0]
      params.query = params.uri
        .slice(params.document.length + 1)
        .replace(/\?/g, '&')
    }

    if (!params.script) {
      params.script = path.posix.join(
        options.documentRoot,
        params.document || params.uri
      )
    }

    const headers = {
      REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers['content-type'],
      CONTENT_LENGTH: req.headers['content-length'],
      CONTENT_DISPOSITION: req.headers['content-disposition'],
      DOCUMENT_ROOT: options.documentRoot,
      SCRIPT_FILENAME: params.script,
      SCRIPT_NAME: params.script.split('/').pop(),
      REQUEST_URI: params.outerUri || params.uri,
      DOCUMENT_URI: params.document || params.uri,
      QUERY_STRING: params.query,
      REQUEST_SCHEME: req.protocol,
      HTTPS: req.protocol === 'https' ? 'on' : undefined,
      REMOTE_ADDR: req.connection.remoteAddress,
      REMOTE_PORT: req.connection.remotePort,
      SERVER_NAME: req.connection.domain,
      SERVER_PROTOCOL: 'HTTP/1.1',
      GATEWAY_INTERFACE: 'CGI/1.1',
      SERVER_SOFTWARE: 'php-fpm for Node',
      REDIRECT_STATUS: 200
    }

    for (const header in headers) {
      if (typeof headers[header] === 'undefined') {
        delete headers[header]
      }
    }

    for (header in req.headers) {
      headers['HTTP_' + header.toUpperCase().split('-').join('_')] =
        req.headers[header]
    }

    if (options.debug) {
      console.log(headers)
    }

    const fail = err => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
      reject(err)
    }
    const php = await fpm
    return new Promise(function(resolve, reject) {
      php.request(headers, function(err, request) {
        if (err) return fail(err)
        
        const parser = new HTTPParser(HTTPParser.RESPONSE)
        const parse = data => parser.execute(data)
        const onHeaders = ({headers}) => {
          let status = 200
          for (let i = 0; i < headers.length; i += 2) {
            const name = headers[i],
              value = headers[i + 1]
            if (name == 'Status') {
              status = parseInt(value.split(' ')[0], 10)
              continue
            }
            const exists = res.getHeader(name)
            const header = exists ? [].concat(exists).concat(value) : value
            res.setHeader(name, header)
          }
          res.writeHead(status)
        }
        const onBody = (chunk, offset, length) => 
          res.write(chunk.slice(offset, offset + length))

        // Skip to header parsing as fcgi does not return a response line
        parser.state = 'HEADER'
        parser[HTTPParser.kOnHeadersComplete] = onHeaders
        parser[HTTPParser.kOnBody] = onBody

        let errors = ''
        request.stderr.on('data', data => (errors += data.toString('utf8')))
        request.stdout.on('data', parse)
        req.pipe(request.stdin)

        request.stdout.on('end', function() {
          parser.finish()
          parser.close()
          if (errors) return fail(new Error(errors))
          res.end()
          resolve()
        })
      })
    })
  }
}
