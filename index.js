const express = require('express')
const cors = require('cors')
const { isProd, gotMock, gpioMock } = require('./utils')
const got = isProd() ? require('got') : gotMock
const parseClients = require('./parse-clients')
const { port, wsPort, wsMiddleman, configFile } = require('./config.js')
const WebSocket = require('ws')
const argon2 = require('argon2')
const { jwtSecret, password } = require('./keys.js')
const JWT = require('./jwt.js')(jwtSecret)
const Gpio = isProd() ? require('onoff').Gpio : gpioMock

const passwords = require('./password-hashes.js')
const warn = message => `\u001B[41mWARNING: ${message}\u001B[0m`
if (passwords.length === 0) {
  console.log('No passwords specified.')
}

// eslint-disable-next-line require-jsdoc
function log() {
  if (process.env.VERBOSE) {
    console.log(arguments)
  }
}

/**
 * __        ______
 * \ \      / / ___|
 *  \ \ /\ / /\___ \
 *   \ V  V /  ___) |
 *    \_/\_/  |____/
 *
 */

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
let initMiddleman

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

// On close set an incrementally increasing timeout to reconnect
const reopenConnection = () => {
  log('Middleman closed')
  setTimeout(initMiddleman, getAuthDelay())
  if (authDepth < maxDepth) {
    authDepth++
  }
}

// Initialize the connection to the ws-middleman service
initMiddleman = () => {
  try {
    middleman = new WebSocket(wsMiddleman)
  } catch (error) {
    console.log(error)
    reopenConnection()
    return
  }

  middleman.on('error', (error) => {
    console.log(warn('A fatal error occurred while attempting to establish middleman connection'))
    console.log(error)
    // If the cert is invalid don't ever reattempt connection
    if (error.code === 'CERT_HAS_EXPIRED') {
      console.log(warn('Will not reattempt connection'))
      // Oroboros
      // This no-op will be run once
      initMiddleman = () => {}
      authDepth = maxDepth
    }
  })

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

const initMiddlemanAuth = (jwt) => {
  apiJWT = jwt
  const decoded = JWT.decode(jwt, false)
  if (!decoded || !decoded.exp) {
    console.log(warn('Middleman JWT cannot be decoded'))
    return
  }
  log('Authenticated: ', jwt)
  // Refresh the jwt 5 minutes before it would expire
  const delay = decoded.exp - Date.now() - (5 * 60 * 1000)
  log(`Reauthentication scheduled in: ${delay}`)
  setTimeout(() => {
    log('Reauthentication requested.')
    middleman.send(JSON.stringify({
      role: 'api',
      type: 'apiReauth',
      apiJWT,
      data: {
        password,
      },
    }))
  }, delay)
}

/** *
 *  _____                 _
 * | ____|_   _____ _ __ | |_ ___
 * |  _| \ \ / / _ \ '_ \| __/ __|
 * | |___ \ V /  __/ | | | |_\__ \
 * |_____| \_/ \___|_| |_|\__|___/
 *
 */

const listeners = {}

/** *
 *  _   _      _
 * | | | | ___| |_ __   ___ _ __ ___
 * | |_| |/ _ \ | '_ \ / _ \ '__/ __|
 * |  _  |  __/ | |_) |  __/ |  \__ \
 * |_| |_|\___|_| .__/ \___|_|  |___/
 *              |_|
 */
// Hoist
let providers
let broadcastUpdate

// Get/set the status of a provider
// 404 on bad id
// 50X on failure
// Reply on success
const handleRequest = async (data, makeRequest, external = true) => {
  const provider = providers[data.id]

  if (!provider) {
    return {
      ...codes[404],
      id: data.id,
    }
  }
  let reply
  try {
    reply = await makeRequest(provider, data)
    reply.id = data.id
    // If the request was successful then fire any handlers
    if (!reply.error && listeners[data.id]) {
      listeners[data.id](data, reply)
    }
  } catch (error) {
    return {
      ...codes[external ? 502 : 500],
      id: data.id,
    }
  }
  return reply
}

/**
 *   ____            _             _ _
 *  / ___|___  _ __ | |_ _ __ ___ | | | ___ _ __ ___
 * | |   / _ \| '_ \| __| '__/ _ \| | |/ _ \ '__/ __|
 * | |__| (_) | | | | |_| | | (_) | | |  __/ |  \__ \
 *  \____\___/|_| |_|\__|_|  \___/|_|_|\___|_|  |___/
 *
 */

// TODO: Rename clients
// Parse controllers from the config
const clients = parseClients(configFile)
const ipToIdMap = {}
Object.entries(clients).forEach(([id, ip]) => {
  ipToIdMap[ip] = id
})

// Get the status of a controller
const getController = data => handleRequest(
  data,
  ip => got(`http://${ip}`).json(),
)

// Set the status of a controller
// 400 on bad action type (toggle/state)
const setController = data => handleRequest(
  data,
  (ip, { state, toggle }) => {
    let url = `http://${ip}`
    if (typeof toggle !== 'undefined') {
      url += `/?toggle=${toggle}`
    } else if (typeof state !== 'undefined') {
      url += `/?state=${state}`
    } else {
      return codes[400]
    }
    log(url)
    return got(url).json()
  },
)

/**
 *   ____ ____ ___ ___
 *  / ___|  _ \_ _/ _ \
 * | |  _| |_) | | | | |
 * | |_| |  __/| | |_| |
 *  \____|_|  |___\___/
 *
 */

// Export GPIO17 as an output
const gpios = {
  dump: new Gpio(17, 'out'),
  fill: new Gpio(27, 'out'),
  pump: new Gpio(22, 'out'),
}

// Set providers now that GPIOs are set
providers = {
  ...clients,
  ...gpios,
}

// Set events for GPIOs
const timers = {}
const autoOff = ({ id }, { state }) => {
  // If the set state is on and there's already a timer then skip
  // if the set state is off and there's no timer then skip
  if (Boolean(state) === Boolean(timers[id])) {
    return
  }

  // Cancel timer
  if (!state) {
    clearTimeout(timers[id])
    timers.id = null
    return
  }

  // Set a new timer
  timers[id] = setTimeout(() => {
    providers[id].writeSync(0)
    timers[id] = null
    broadcastUpdate({ id, state: 0 })
  }, 60 * 60 * 1000)
}
listeners.dump = autoOff
listeners.fill = autoOff

process.on('SIGINT', () => {
  // pm2 Does fire a SIGINT
  Object.values(gpios).forEach(gpio => gpio.unexport())
  process.exit(0)
})

const getGpio = data => handleRequest(
  data,
  async gpio => ({
    state: await gpio.read(),
  }),
  false,
)

const setGpio = data => handleRequest(
  data,
  async (gpio, { id, state, toggle }) => {
    let value
    if (typeof toggle !== 'undefined') {
      value = gpio.readSync() ^ 1
    } else if (typeof state !== 'undefined') {
      value = state
    } else {
      return codes[400]
    }
    log({ id, value })
    gpio.writeSync(value)
    return { state: value }
  },
  false,
)

/**
 *   ____ _ _            _
 *  / ___| (_) ___ _ __ | |_ ___
 * | |   | | |/ _ \ '_ \| __/ __|
 * | |___| | |  __/ | | | |_\__ \
 *  \____|_|_|\___|_| |_|\__|___/
 *
 */

// Helpers to handle any provider
const getState = data => clients[data.id] ? getController(data) : getGpio(data)
const setState = data => clients[data.id] ? setController(data) : setGpio(data)

// Send an update to each connected client as well as the middleman
broadcastUpdate = (reply) => {
  // Construct a message
  const message = {
    type: 'update',
    data: Array.isArray(reply) ? reply : [reply],
  }
  const stringified = JSON.stringify(message)

  // Send to each client
  ws.clients.forEach(client => client.send(stringified))

  // If theres a middleman broadcast to it
  if (!middleman || middleman.readyState !== WebSocket.OPEN) {
    return
  }
  message.role = 'api'
  message.apiJWT = apiJWT
  middleman.send(JSON.stringify(message))
}

// Refresh the status of a provider and broadcast to the network
// This is split out so that operations can be async
const refreshState = async (id) => {
  const reply = await getState({ id })
  // Don't send 502s to every client on a general refresh
  if (reply.code) {
    return
  }
  broadcastUpdate(reply)
}

// Refresh all providers and broadcast an update for each
const allIds = Object.keys(providers)
const refreshProviders = () => {
  for (const id of allIds) {
    // This is async
    refreshState(id)
  }
}

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
  if (role === 'middleman') {
    if (type === 'apiAuth') {
      initMiddlemanAuth(data.jwt)
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
    // Set status of controller or GIPO
    } else if (type === 'set') {
      reply = await setState(data)
    // Get status of controller or GIPO
    } else if (type === 'get') {
      reply = await getState({ id: data })
    // Refresh the entire network of controllers
    } else if (type === 'refresh') {
      refreshProviders()
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
initMiddleman()

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
  const reply = getController({ id: request.query.id })
  if (reply.code) {
    response.status(reply.code)
  }
  return response.send(reply.error || reply)
})

app.listen(port, () => console.log(`Listening on: ${port}`))
