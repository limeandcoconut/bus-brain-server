// const fastify = require('fastify')({ logger: false })
const { isProd, gotMock } = require('./utils')
const got = isProd() ? require('got') : gotMock
const parseClients = require('./parse-clients')
const { port, configFile } = require('./config.js')

const clients = parseClients(configFile)

// fastify.register(require('fastify-formbody'))
// fastify.register(require('fastify-cors'), {
//   methods: ['GET', 'POST'],
//   origin: [
//     webPanelHostRegex,
//     ...Object.values(clients),
//   ],
// })
const express = require('express')
const bodyParser = require('body-parser')
const cors = require('cors')
const app = express()
app.use(cors({
  methods: ['GET', 'POST'],
  origin: [
    /:\/\/das-mechabus\.jacobsmith\.tech/,
    // These are the local machines
    /:\/\/10.0.0.[2-4]/,
    ...Object.values(clients),
  ],
}))
app.use(bodyParser.urlencoded({ extended: true }))

app.post('/', async (request, response) => {
  const { id, state, action } = request.body
  const client = clients[id]

  if (!client) {
    response.set(404)
    return response.send({ Error: 'Controller not found' })
  }

  if (action === 'toggle') {
    const reply = await got(`http://${client}/?action=${action}`)
    console.log(reply)
    return response.send(reply)
  }
  if (typeof state === 'number') {
    const reply = await got(`http://${client}/?state=${state}`)
    console.log(reply)
    return response.send(reply)
  }
  response.set(400)
  return response.send({ Error: 'Invalid request' })
})

app.listen(port, () => console.log(`Listening on: ${port}`))

// ;(async () => {
//   await app.listen(port)
//   console.log(`server listening on ${fastify.server.address().port}`)
// })()
