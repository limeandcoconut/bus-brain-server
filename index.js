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

// The server than manages clients and controllers
const ws = new WebSocket.Server({ port: wsPort })

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

/**
 *  __  __ _     _     _ _
 * |  \/  (_) __| | __| | | ___ _ __ ___   __ _ _ __
 * | |\/| | |/ _` |/ _` | |/ _ \ '_ ` _ \ / _` | '_ \
 * | |  | | | (_| | (_| | |  __/ | | | | | (_| | | | |
 * |_|  |_|_|\__,_|\__,_|_|\___|_| |_| |_|\__,_|_| |_|
 *
 * https://patorjk.com/software/taag/#p=display&c=c&f=Standard&t=Middleman
 */

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
    // Authorize as the api
    middleman.send(JSON.stringify({
      role: 'api',
      type: 'apiAuth',
      data: {
        password,
      },
    }))
  })

  // Handle messages the same way a client does
  middleman.on('message', createHandler(middleman))

  // Repoen on fail
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

/**
 *   ____            _             _ _
 *  / ___|___  _ __ | |_ _ __ ___ | | | ___ _ __ ___
 * | |   / _ \| '_ \| __| '__/ _ \| | |/ _ \ '__/ __|
 * | |__| (_) | | | | |_| | | (_) | | |  __/ |  \__ \
 *  \____\___/|_| |_|\__|_|  \___/|_|_|\___|_|  |___/
 *
 */

// Parse controllers from the config
const clients = parseClients(configFile)
const ipToIdMap = {}
Object.entries(clients).forEach(([id, ip]) => {
  ipToIdMap[ip] = id
})

// Request the status of a controller
// 404 on bad id
// 502 on failure
// Reply on success
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

// Set the status of a controller
// 404 on bad id
// 400 on bad action type (toggle/state)
// 502 on failure
// Reply on success
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
  log(url)
  let reply
  try {
    reply = await got(url).json()
  } catch (error) {
    return codes[502]
  }
  reply.id = id
  return reply
}

// Send an update to each connected client as well as the middleman
const broadcastUpdate = (reply) => {
  // Construct a message
  const message = {
    type: 'update',
    data: Array.isArray(reply) ? reply : [reply],
  }
  const stringified = JSON.stringify(message)

  // Send to each client
  ws.clients.forEach(client => client.send(stringified))

  // If theres a middleman broadcast to it
  if (middleman.readyState !== WebSocket.OPEN) {
    return
  }
  message.role = 'api'
  message.apiJWT = apiJWT
  middleman.send(JSON.stringify(message))
}

// Refresh the status of a controller and broadcast to the network
// This is split out so that operations can be async
const updateController = async (id) => {
  const reply = await getController(id)
  // Don't send 502s to every client on a general refresh
  if (reply.code) {
    return
  }
  broadcastUpdate(reply)
}

// Refresh all controllers and broadcast an update for each
const refreshControllers = () => {
  for (const id of Object.keys(clients)) {
    // This is async
    updateController(id)
  }
}

/**
 *   ____ _ _            _
 *  / ___| (_) ___ _ __ | |_ ___
 * | |   | | |/ _ \ '_ \| __/ __|
 * | |___| | |  __/ | | | |_\__ \
 *  \____|_|_|\___|_| |_|\__|___/
 *
 */

// Used when authenticating or refreshing a jwt
const getAuthReply = () => ({
  type: 'auth',
  data: {
    // Generate a token that's good for 30 minutes
    jwt: JWT.encode({ exp: Date.now() + (30 * 60 * 1000) }),
  },
})

// Authenticate or fail
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

// Factory for socket handler (handles both clients and messages from the
// middleman)
createHandler = socket => async (message) => {
  const { type, jwt, data = {}, id, role } = JSON.parse(message)

  log('Received: ', { type, jwt, id, data, role })

  let reply
  // If this is a response sent to the api as a ws client, handle appropriately
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

  // If a client is attempting to authorize with this server
  if (type === 'auth') {
    reply = await authenticate(data)
  // If a client isn't trying to auth and isn't authed
  } else if (!jwt) {
    reply = codes[401]
  // If the client *is* authorized
  } else {
    const decoded = JWT.decode(jwt)
    // If the jwt is expired
    if (!decoded || decoded.exp < Date.now()) {
      reply = codes[401]
    // Get a newer JWTt
    } else if (type === 'reauth') {
      reply = getAuthReply()
    // Set a controller's status
    } else if (type === 'set') {
      reply = await setController(data)
    // Get a controller's status
    } else if (type === 'get') {
      reply = await getController(data)
    // Communicate with a brain's gpio
    } else if (type === 'operate') {
      reply = await (async (data) => {
        console.log('onoff' + data)
      })()
    // Refresh the entire network of controllers
    } else if (type === 'refresh') {
      refreshControllers()
      return
    // Bad request
    } else {
      reply = codes[400]
    }
  }

  // Format and send errors individually
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
  // Format and send auth updates individually
  if (reply.data && reply.data.jwt) {
    reply.id = id
    reply.role = 'api'
    reply.apiJWT = apiJWT
    socket.send(JSON.stringify(reply))
    return
  }

  // Everything else is a status update
  // Broadcast to all clients
  broadcastUpdate(reply)
}

// Init connection
// initMiddleman()

// Prepare to be the api to clients.
ws.on('connection', async (socket) => {
  socket.on('message', createHandler(socket))
})

/**
 *  _____
 * | ____|_  ___ __  _ __ ___  ___ ___
 * |  _| \ \/ / '_ \| '__/ _ \/ __/ __|
 * | |___ >  <| |_) | | |  __/\__ \__ \
 * |_____/_/\_\ .__/|_|  \___||___/___/
 *            |_|
 */

// Express is only used for communication with the controllers
const app = express()

app.use(cors({
  methods: ['GET', 'POST'],
  origin: [
    /:\/\/mechabus\.jacobsmith\.tech/,
    /:\/\/das-mechabus\.jacobsmith\.tech/,
    /:\/\/localhost:/,
    // These are the local machines
    /:\/\/10.0.0.[2-4]/,
    ...Object.values(clients),
  ],
}))

app.use(express.urlencoded({ extended: false }))
app.use(express.json())

const asyncBroadcast = async reply => broadcastUpdate(reply)
const lookupRequestId = request => ipToIdMap[request.header('Origin')]
const lookupPartnerId = id => 'swi' + id.slice(3, 6)

// Used for passing information about status changes
app.post('/', async (request, response) => {
  let reply
  // If this is a notification from one of the switches of a change in status
  if (request.body.update) {
    reply = request.body
    // Look up the sender by Origin header
    reply.id = lookupRequestId(request)
    // 400 if unknown
    if (!reply.id) {
      reply = codes[400]
    }
  // If this is an instruction to change a partner controller
  } else {
    // Send a set request as dictated
    reply = await setController({
      ...request.body,
      id: lookupPartnerId(lookupRequestId(request)),
    })
  }
  // Set status if appropriate
  if (reply.code) {
    response.status(reply.code)
  }
  // Error without an update brodcast
  if (reply.error) {
    return response.send(reply.error)
  }
  // Broadcast async, then respond
  asyncBroadcast(reply)
  return response.send(reply)
})

// Used to get the status of a controller
app.get('/', async (request, response) => {
  const reply = getController(request.query.id)
  if (reply.code) {
    response.status(reply.code)
  }
  return response.send(reply.error || reply)
})

app.listen(port, () => console.log(`Listening on: ${port}`))
