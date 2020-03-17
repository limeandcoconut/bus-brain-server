const sleep = time => new Promise(resolve => setTimeout(resolve, time))

const store = {}

module.exports = {
  isDev: () => process.env.NODE_ENV === 'development',
  isProd: () => process.env.NODE_ENV === 'production',
  sleep,
  gotMock: (url) => {
    const [, ip, action, state] = url.match(/(\d+\.\d+\.\d+\.\d+)\/?(?:\?(state|toggle)=(\d))?/)
    console.log(ip, action, state)

    if (action === 'state') {
      store[ip] = state
    } else if (typeof store[ip] === 'undefined') {
      store[ip] = Math.round(Math.random())
    } else if (action === 'toggle') {
      store[ip] = 1 - store[ip]
    }

    return {
      json: async () => {
        await sleep(200)
        return {
          state: store[ip],
          button: Math.round(Math.random()),
          milliseconds: Math.round(Math.random() * 5000),
        }
      },
    }
  },
}

