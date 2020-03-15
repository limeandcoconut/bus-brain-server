const isProd = require('./utils').isProd()

module.exports = {
  port: 3998,
  configFile: isProd ? '/etc/dnsmasq.conf' : './test.conf',
}
