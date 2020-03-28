const isProd = require('./utils').isProd()

module.exports = {
  port: 3998,
  wsPort: 3535,
  wsMiddleman: 'wss://mechabus.jacobsmith.tech',
  configFile: isProd ? '/etc/dnsmasq.conf' : './test.conf',
}
