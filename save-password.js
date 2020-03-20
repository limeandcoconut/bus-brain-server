
const crypto = require('crypto')
const salt = crypto.randomBytes(32)
const argon2 = require('argon2')
const fs = require('fs')
const path = './password-hashes.js'

;(async () => {
  if (fs.existsSync(path)) {
    console.log('Nothing done. Will not overwrite existing file.')
    return
  }
  const passwords = process.argv.slice(2)
  const hashed = await Promise.all(passwords.map(password => argon2.hash(password, { salt })))
  fs.writeFileSync(path, `module.exports=${JSON.stringify(hashed)}`)
  console.log('done')
})()
