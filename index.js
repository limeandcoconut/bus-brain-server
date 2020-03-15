const express = require('express')
const cors = require('cors')
const { isProd, gotMock } = require('./utils')
const got = isProd() ? require('got') : gotMock
const parseClients = require('./parse-clients')
const { port, configFile } = require('./config.js')

const app = express()
const clients = parseClients(configFile)

app.use(cors({
  methods: ['GET', 'POST'],
  origin: [
    /:\/\/das-mechabus\.jacobsmith\.tech/,
    /:\/\/localhost:/,
    // These are the local machines
    /:\/\/10.0.0.[2-4]/,
    ...Object.values(clients),
  ],
}))

app.use(express.json())

app.post('/', async (request, response) => {
  const { id, state, action } = request.body
  const client = clients[id]

  if (!client) {
    response.status(404)
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
  response.status(400)
  return response.send({ Error: 'Invalid request' })
})

app.listen(port, () => console.log(`Listening on: ${port}`))
