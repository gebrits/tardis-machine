import { IncomingMessage } from 'http'
import { combine, Exchange, replay, ReplayOptions } from 'tardis-dev'
import url from 'url'
import WebSocket from 'ws'
import { debug } from '../debug'
import { wait } from '../helpers'
import { SubscriptionMapper, subscriptionsMappers } from './subscriptionsmappers'

const replaySessions: { [sessionKey: string]: ReplaySession | undefined } = {}

export function replayWS(ws: WebSocket, req: IncomingMessage) {
  const parsedQuery = url.parse(req.url!, true).query
  const from = parsedQuery['from'] as string
  const to = parsedQuery['to'] as string
  const replaySessionKey = `${from}-${to}`
  // if there are multiple separate ws connections being made for the same date ranges
  // in short time frame (5 seconds)
  // consolidate them in single replay session that will make sure that messages being send via multiple websockets connections
  // are  synchronized by local timestamp

  let matchingReplaySessionMeta = replaySessions[replaySessionKey] && replaySessions[replaySessionKey]

  if (matchingReplaySessionMeta === undefined) {
    const newReplaySession = new ReplaySession()

    replaySessions[replaySessionKey] = newReplaySession
    matchingReplaySessionMeta = newReplaySession

    newReplaySession.onFinished(() => {
      replaySessions[replaySessionKey] = undefined
    })
  }

  if (matchingReplaySessionMeta.hasStarted) {
    const message = 'trying to add new WS connection to replay session that already started'
    debug(message)
    ws.close(1011, message)
    return
  }

  matchingReplaySessionMeta.addToSession(new WebsocketConnection(ws, parsedQuery['exchange'] as Exchange, from, to))
}

class ReplaySession {
  private readonly _connections: WebsocketConnection[] = []
  private _hasStarted: boolean = false

  constructor() {
    const SESSION_START_DELAY_MS = 5000

    debug('creating new ReplaySession')

    setTimeout(async () => {
      try {
        await this._start()
      } catch (e) {
        debug('received error in ReplaySession, %o', e)
        await this._closeAllConnections(e)
      } finally {
        this._onFinishedCallback()
      }
    }, SESSION_START_DELAY_MS)
  }

  public addToSession(websocketConnection: WebsocketConnection) {
    if (this._hasStarted) {
      throw new Error('Replay session already started')
    }

    this._connections.push(websocketConnection)
    debug('added new connection to ReplaySession, %s', websocketConnection)
  }

  public get hasStarted() {
    return this._hasStarted
  }

  private _onFinishedCallback: () => void = () => {}

  private async _start() {
    debug('starting ReplaySession, %s', this._connections.join(', '))
    this._hasStarted = true

    const connectionsWithoutSubscriptions = this._connections.filter(c => c.subscriptionsCount === 0)
    if (connectionsWithoutSubscriptions.length > 0) {
      throw new Error(`No subscriptions received for websocket connection ${connectionsWithoutSubscriptions[0]}`)
    }

    // map connection to replay messages streams enhanced with addtional ws field so
    // when we combine streams by localTimestamp we'll know which ws we should send given message via
    const messagesWithConnections = this._connections.map(async function*(connection) {
      const messages = replay({
        ...connection.replayOptions,
        skipDecoding: true,
        withDisconnects: false
      })

      for await (const { localTimestamp, message } of messages) {
        yield {
          ws: connection.ws,
          localTimestamp: new Date(localTimestamp.toString()),
          message
        }
      }
    })

    for await (const { ws, message } of combine(...messagesWithConnections)) {
      // wait until  buffer is empty
      // sometimes slow clients can't keep up with messages arrival rate so we need to throttle
      // https://nodejs.org/api/net.html#net_socket_buffersize
      while (ws.bufferedAmount > 0) {
        await wait(1)
      }

      ws.send(message, {
        binary: false
      })
    }

    await this._closeAllConnections()

    debug(
      'finished ReplaySession with %d connections, %s',
      this._connections.length,
      this._connections.map(c => c.toString())
    )
  }

  private async _closeAllConnections(error: Error | undefined = undefined) {
    for (let i = 0; i < this._connections.length; i++) {
      const connection = this._connections[i]

      // let's wait until buffer is empty before closing normal connections
      while (!error && connection.ws.bufferedAmount > 0) {
        await wait(100)
      }

      connection.close(error)
    }
  }

  public onFinished(onFinishedCallback: () => void) {
    this._onFinishedCallback = onFinishedCallback
  }
}

class WebsocketConnection {
  public readonly replayOptions: ReplayOptions<any>
  private readonly _subscriptionsMapper: SubscriptionMapper
  public subscriptionsCount = 0

  constructor(public readonly ws: WebSocket, exchange: Exchange, from: string, to: string) {
    this.replayOptions = {
      exchange,
      from,
      to,
      filters: []
    }

    if (!subscriptionsMappers[exchange]) {
      throw new Error(`Exchange ${exchange} is not supported via /ws-replay Websocket API, please use HTTP streaming API instead.`)
    }

    this._subscriptionsMapper = subscriptionsMappers[exchange]!
    this.ws.on('message', this._convertSubscribeRequestToFilter.bind(this))
  }

  public close(error: Error | undefined = undefined) {
    if (error) {
      debug('Closed websocket connection %s, error: %o', this, error)
      this.ws.close(1011, error.toString())
    } else {
      debug('Closed websocket connection %s', this)
      this.ws.close(1000, 'WS replay finished')
    }
  }

  public toString() {
    return `${JSON.stringify(this.replayOptions)}`
  }

  private _convertSubscribeRequestToFilter(message: string) {
    try {
      const messageDeserialized = JSON.parse(message)

      if (this._subscriptionsMapper.canHandle(messageDeserialized)) {
        // if there is a subscribe message let's map it to filters and add those to replay options
        const filters = this._subscriptionsMapper.map(messageDeserialized)
        debug('Received subscribe websocket message: %s, mapped filters: %o', message, filters)
        this.replayOptions.filters.push(...filters)
        this.subscriptionsCount++
      } else {
        debug('Ignored websocket message %s', message)
      }
    } catch (e) {
      console.error('convertSubscribeRequestToFilter Error', e)
      debug('Ignored websocket message %s, error %o', message, e)
    }
  }
}
