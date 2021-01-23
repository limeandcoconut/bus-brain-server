module.exports = {
  apps: [{
    name: 'api',
    script: 'index.js',

    // Options reference: https://pm2.io/doc/en/runtime/reference/ecosystem-file/
    instances: 1,
    autorestart: true,
    watch: false,
    // eslint-disable-next-line camelcase
    max_memory_restart: '150M',
    env: {
      NODE_ENV: 'production',
    },
  }],
}
