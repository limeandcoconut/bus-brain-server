const express = require('express')
const cors = require('cors')
const { isProd, gotMock } = require('./utils')
const got = isProd() ? require('got') : gotMock
const parseClients = require('./parse-clients')
const { port, configFile } = require('./config.js')
const WebSocket = require('ws')

const ws = new WebSocket.Server({ port: 3535 })

const app = express()
const clients = parseClients(configFile)

const clientsArray = Object.values(clients)

const code400 = {
  code: 400,
  error: 'Invalid request',
}

const getController = async (id) => {
  const client = clients[id]

  if (!client) {
    return {
      code: 404,
      error: 'Controller not found',
    }
  }
  const reply = await got(`http://${client}`).json()
  reply.id = id
  return reply
}

const setController = async ({ id, state, toggle }) => {
  const client = clients[id]

  if (!client) {
    return {
      code: 404,
      error: 'Controller not found',
    }
  }

  if (typeof toggle !== 'undefined') {
    const reply = await got(`http://${client}/?toggle=${toggle}`).json()
    reply.id = id
    return reply
  }
  if (typeof state !== 'undefined') {
    const reply = await got(`http://${client}/?state=${state}`).json()
    reply.id = id
    return reply
  }

  return code400
}

const refreshControllers = () => Promise.all(Object.keys(clients).map(
  async id => getController(id),
))

ws.on('connection', async (socket) => {
  socket.on('message', async (message) => {
    const { type, data } = JSON.parse(message)

    console.log(type, data)
    let reply
    if (type === 'set') {
      reply = await setController(data)
    } else if (type === 'get') {
      reply = await setController(data)
    } else if (type === 'refresh') {
      reply = await refreshControllers()
    } else {
      reply = code400
    }

    if (reply.error) {
      reply = {
        type: 'error',
        data: reply,
      }
    } else {
      reply = {
        type: 'update',
        data: Array.isArray(reply) ? reply : [reply],
      }
    }
    socket.send(JSON.stringify(reply))
    return

  })

  socket.send(JSON.stringify({
    type: 'update',
    data: await refreshControllers(),
  }))
})

app.use(cors({
  methods: ['GET', 'POST'],
  origin: [
    /:\/\/das-mechabus\.jacobsmith\.tech/,
    /:\/\/localhost:/,
    // These are the local machines
    /:\/\/10.0.0.[2-4]/,
    ...clientsArray,
  ],
}))

app.use(express.urlencoded())
app.use(express.json())

app.post('/', async (request, response) => {
  const reply = await setController(request.body)
  if (reply.code) {
    response.status(reply.code)
  }
  return response.send(reply.error || reply)
})

app.get('/', async (request, response) => {
  const reply = getController(request.query.id)
  if (reply.code) {
    response.status(reply.code)
  }
  return response.send(reply.error || reply)
})

app.listen(port, () => console.log(`Listening on: ${port}`))
