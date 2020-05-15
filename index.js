const express = require('express')
const cors = require('cors')
const { isProd, gotMock } = require('./utils')
const got = isProd() ? require('got') : gotMock
const parseClients = require('./parse-clients')
const { port, wsPort, wsMiddleman, configFile } = require('./config.js')
const WebSocket = require('ws')
const argon2 = require('argon2')
const { jwtSecret, password } = require('./keys.js')
const JWT = require('./jwt.js')(jwtSecret)

const passwords = require('./password-hashes.js')
if (passwords.length === 0) {
  console.log('\u001B[41mWARNING: No passwords specified.\u001b[0m')
}

// eslint-disable-next-line require-jsdoc
function log() {
  if (process.env.VERBOSE) {
    console.log(arguments)
  }
}

const ws = new WebSocket.Server({ port: wsPort })

// Intentional hoist
let createHandler
let reopenConnection

let authDepth = 1
const maxDepth = 6
const authDelay = 500
const getAuthDelay = (depth = authDepth) => authDelay * Math.pow(3, depth)
// 1500
// 4500
// 13500
// 40500
// 121500
// 364500 (~6 min)

let apiJWT
let middleman
// Initialize the connection to the ws-middleman service
const initMiddleman = () => {
  try {
    middleman = new WebSocket(wsMiddleman)
  } catch (error) {
    console.log(error)
    reopenConnection()
    return
  }

  // Auth on open
  middleman.on('open', () => {
    log('Middleman opened')
    // After the maximum amount of time reset the auth delay for quick retries
    setTimeout(() => {
      authDepth = 1
    }, getAuthDelay(maxDepth))
    // Authroize as the api
    middleman.send(JSON.stringify({
      role: 'api',
      type: 'apiAuth',
      data: {
        password,
      },
    }))
  })

  middleman.on('message', createHandler(middleman))

  middleman.on('close', reopenConnection)

  // Log the heartbeat
  middleman.on('ping', () => log('ping'))
}

// On close set an incrementally increasing timeout to reconnect
reopenConnection = () => {
  log('Middleman closed')
  setTimeout(initMiddleman, getAuthDelay())
  if (authDepth < maxDepth) {
    authDepth++
  }
}

// Express is only used for the controllers
const app = express()
// Parse controllers from the config
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
  // Try all passwords
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

const sendUpdate = (reply) => {
  const message = {
    type: 'update',
    data: Array.isArray(reply) ? reply : [reply],
  }
  const stringified = JSON.stringify(message)
  ws.clients.forEach(client => client.send(stringified))

  // If theres a middleman broadcast to it
  if (middleman.readyState !== WebSocket.OPEN) {
    return
  }
  message.role = 'api'
  message.apiJWT = apiJWT
  middleman.send(JSON.stringify(message))
}

const updateController = async (id) => {
  const reply = await getController(id)
  sendUpdate(reply)
}

const refreshControllers = () => {
  for (const id of Object.keys(clients)) {
    updateController(id)
  }
}

createHandler = socket => async (message) => {
  const { type, jwt, data = {}, id, role } = JSON.parse(message)

  log('Received: ', { type, jwt, id, data, role })

  let reply
  // If this is a response sent to the api as a ws client handle appropriately
  if (role === 'api') {
    if (type === 'apiAuth') {
      apiJWT = data.jwt
      log('Authenticated: ', apiJWT)
    } else {
      log('Error: Failed to authenticate with middleman service')
      log(data)
    }
    return
  }
  if (type === 'auth') {
    reply = await authenticate(data)
  } else if (!jwt) {
    reply = codes[401]
  } else {
    const decoded = JWT.decode(jwt)
    if (!decoded || decoded.exp < Date.now()) {
      reply = codes[401]
    } else if (type === 'reauth') {
      reply = getAuthReply()
    } else if (type === 'set') {
      reply = await setController(data)
    } else if (type === 'get') {
      reply = await getController(data)
    } else if (type === 'operate') {
      reply = await (async (data) => {
        console.log('onoff' + data)
      })()
    } else if (type === 'refresh') {
      refreshControllers()
      return
    } else {
      reply = codes[400]
    }
  }

  if (reply.error) {
    socket.send(JSON.stringify({
      type: 'error',
      id,
      role: 'api',
      apiJWT,
      data: reply,
    }))
    return
  }
  if (reply.data && reply.data.jwt) {
    reply.id = id
    reply.role = 'api'
    reply.apiJWT = apiJWT
    socket.send(JSON.stringify(reply))
    return
  }

  // Broadcast to all clients
  sendUpdate(reply)
}

// Init connection
initMiddleman()

// Prepare to be the api to clients.
ws.on('connection', async (socket) => {
  socket.on('message', createHandler(socket))
})

app.use(cors({
  methods: ['GET', 'POST'],
  origin: [
    /:\/\/mechabus\.jacobsmith\.tech/,
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
  let reply
  if (request.body.update) {
    reply = request.body
  } else {
    reply = await setController(request.body)
    if (reply.code) {
      response.status(reply.code)
    }
    if (reply.error) {
      return response.send(reply.error)
    }
  }
  sendUpdate(reply)
  return response.send(reply)
})

app.get('/', async (request, response) => {
  const reply = getController(request.query.id)
  if (reply.code) {
    response.status(reply.code)
  }
  return response.send(reply.error || reply)
})

app.listen(port, () => console.log(`Listening on: ${port}`))
