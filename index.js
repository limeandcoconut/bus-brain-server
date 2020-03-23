const express = require('express')
const cors = require('cors')
const { isProd, gotMock } = require('./utils')
const got = isProd() ? require('got') : gotMock
const parseClients = require('./parse-clients')
const { port, configFile } = require('./config.js')
const WebSocket = require('ws')
const argon2 = require('argon2')
const { jwtSecret } = require('./keys.js')
const JWT = require('./jwt.js')(jwtSecret)

const passwords = require('./password-hashes.js')
if (passwords.length === 0) {
  console.log('\u001B[41mWARNING: No passwords specified.\u001b[0m')
}

const ws = new WebSocket.Server({ port: 3535 })

const app = express()
const clients = parseClients(configFile)

const clientsArray = Object.values(clients)

const codes = {
  400: {
    code: 400,
    error: 'Invalid request',
  },
  401: {
    code: 401,
    error: 'Unauthorized',
  },
  404: {
    code: 404,
    error: 'Controller not found',
  },
  502: {
    code: 502,
    error: 'Controller unreachable',
  },
}

const getAuthReply = () => ({
  type: 'auth',
  data: {
    // Generate a token that's good for 30 minutes
    jwt: JWT.encode({ exp: Date.now() + (30 * 60 * 1000) }),
  },
})

const authenticate = async ({ password }) => {
  for (const record of passwords) {
    if (!await argon2.verify(record, password)) {
      continue
    }
    return getAuthReply()
  }
  return codes[401]
}

const getController = async (id) => {
  const client = clients[id]

  if (!client) {
    return codes[404]
  }
  let reply
  try {
    reply = await got(`http://${client}`).json()
  } catch (error) {
    return codes[502]
  }
  reply.id = id
  return reply
}

const setController = async ({ id, state, toggle }) => {
  const client = clients[id]

  if (!client) {
    return codes[404]
  }
  let url = `http://${client}`
  if (typeof toggle !== 'undefined') {
    url += `/?toggle=${toggle}`
  } else if (typeof state !== 'undefined') {
    url += `/?state=${state}`
  } else {
    return codes[400]
  }

  let reply
  try {
    reply = await got(url).json()
    reply.id = id
  } catch (error) {
    reply = codes[502]
  }
  return reply
}

const refreshControllers = () => Promise.all(Object.keys(clients).map(
  async id => getController(id),
))

ws.on('connection', async (socket) => {
  socket.on('message', async (message) => {
    const { type, jwt, data = {} } = JSON.parse(message)

    console.log(type, data, jwt)

    let reply
    if (type === 'auth') {
      reply = await authenticate(data)
    } else if (!jwt) {
      reply = codes[401]
    } else {
      const decoded = JWT.decode(jwt)
      if (!decoded) {
        reply = codes[401]
      } else if (decoded.exp < Date.now()) {
        reply = codes[401]
      } else if (type === 'reauth') {
        reply = getAuthReply()
      } else if (type === 'set') {
        reply = await setController(data)
      } else if (type === 'get') {
        reply = await setController(data)
      } else if (type === 'refresh') {
        reply = await refreshControllers()
      } else {
        reply = codes[400]
      }
    }

    if (reply.error) {
      socket.send(JSON.stringify({
        type: 'error',
        data: reply,
      }))
      return
    }
    if (reply.data && reply.data.jwt) {
      console.log(reply)
      socket.send(JSON.stringify(reply))
      return
    }

    ws.clients.forEach((client) => {
      client.send(JSON.stringify({
        type: 'update',
        data: Array.isArray(reply) ? reply : [reply],
      }))
    })
  })
})

app.use(cors({
  methods: ['GET', 'POST'],
  origin: [
    /:\/\/mechabus\.jacobsmith\.tech/,
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
