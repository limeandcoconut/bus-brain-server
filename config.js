const isProd = require('./utils').isProd()

module.exports = {
  port: 3998,
  configFile: isProd ? '/etc/dnsmasq.conf' : './test.conf',
  // This will be used in a new RegExp
  webPanelHostRegex: isProd ? /:\/\/das-mechabus\.jacobsmith\.tech/ : /:\/\/localhost:/,
}
