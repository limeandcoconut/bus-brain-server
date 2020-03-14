const sleep = time => new Promise(resolve => setTimeout(resolve, time))

module.exports = {
  isDev: () => process.env.NODE_ENV === 'development',
  isProd: () => process.env.NODE_ENV === 'production',
  sleep,
  gotMock: async (url) => {
    await sleep(200)
    const match = url.match(/\?state=(\d)/)
    if (match) {
      return match[1]
    }
    return 'toggled'
  },
}

