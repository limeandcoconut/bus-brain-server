const fs = require('fs')
const hostRegex = /dhcp-host=([\d\w.:,]*)\n/gmi

module.exports = (filePath) => {
  const file = fs.readFileSync(filePath, 'utf8')
  let matches = hostRegex.exec(file)
  let clients = {}
  do {
    if (matches) {
      const [, id, ip] = matches[1].split(',')
      clients[id] = ip
    }
    matches = hostRegex.exec(file)
  } while (matches !== null)

  return clients
}
