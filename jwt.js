const crypto = require('crypto')

const base64Encode = string => Buffer.from(string).toString('base64').toString('utf-8')

const base64Decode = string => Buffer.from(string, 'base64').toString('utf-8')

// Takes head and payload encoded as base64 and returns a hash
const generateCheckSum = (head, payload, secret) => {
  return crypto
  .createHmac('sha256', secret)
  .update(`${head}.${payload}`)
  .digest('base64')
  .toString('utf8')
}

const alg = { alg: 'HS256', typ: 'JWT' }

module.exports = secret => ({
  encode: (data) => {
    const header = base64Encode(JSON.stringify(alg))
    const payload = base64Encode(JSON.stringify(data))
    const checkSum = generateCheckSum(header, payload, secret)
    return `${header}.${payload}.${checkSum}`
  },
  decode: (jwt) => {
    const [header, payload, hash] = jwt.split('.')
    const checkSum = generateCheckSum(header, payload, secret)
    console.log(hash, checkSum)
    if (hash !== checkSum) {
      return false
    }
    return JSON.parse(base64Decode(payload))
  },
})
