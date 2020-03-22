module.exports = {
  apps: [{
    name: 'api',
    script: 'index.js',

    // Options reference: https://pm2.io/doc/en/runtime/reference/ecosystem-file/
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '150M', // eslint-disable-line camelcase
    env: {
      NODE_ENV: 'production',
    },
  }],
}
