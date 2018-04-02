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

    const formatHeader = header =>
      header.toUpperCase().split('-').join('_')

    for (header in req.headers)
      headers['HTTP_' + formatHeader(header)] = req.headers[header]

    if (options.debug) console.log(headers)

    const php = await fpm
    return new Promise(function(resolve, reject) {
      const fail = err => {
        if (!res.headersSent) res.writeHead(500)
        res.end()
        reject(err)
      }
      php.request(headers, function(err, request) {
        if (err) return fail(err)

        const errors = []
        const parser = new HTTPParser(HTTPParser.RESPONSE)
        const parse = data => parser.execute(data)
        const headerValue = (name, value) => {
          const exists = res.getHeader(name)
          return exists ? [].concat(exists).concat(value) : value
        }
        const setHeader = (name, value) => {
          if (name == 'Status')
            res.statusCode = parseInt(value.split(' ')[0], 10)
          else res.setHeader(name, headerValue(name, value))
        }
        const writeHead = ({headers}) => {
          while (headers.length) setHeader(headers.shift(), headers.shift())
        }
        const writeBody = (chunk, offset, length) =>
          res.write(chunk.slice(offset, offset + length))
        const getErrors = () =>
          new Error(Buffer.concat(errors).toString('utf8'))
        const finish = () => {
          if (errors.length) fail(getErrors())
          else resolve(res.end())
        }

        parser.state = 'HEADER'
        parser[HTTPParser.kOnHeadersComplete] = writeHead
        parser[HTTPParser.kOnBody] = writeBody
        request.stderr.on('data', errors.push)
        request.stdout.on('data', parse)
        request.stdout.on('end', finish)
        req.pipe(request.stdin)
      })
    })
  }
}
