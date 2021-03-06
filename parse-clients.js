const fs = require('fs')
const hostRegex = /dhcp-host=([\d\w.:,]*)\n/gmi

module.exports = (filePath) => {
  const file = fs.readFileSync(filePath, 'utf8')
  let matches = hostRegex.exec(file)
  let clients = {}
  do {
    if (matches) {
      let [, id, ip] = matches[1].split(',')
      // Insert dots because dnsmasq doesn't allow dots in names
      id = `${id.slice(0, 4)}.${id[4]}${id[5] ? `.${id[5]}` : ''}`
      clients[id] = ip
    }
    matches = hostRegex.exec(file)
  } while (matches !== null)
  return clients
}
