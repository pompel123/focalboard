// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {ClientConfig} from './config/clientConfig'

import {Utils} from './utils'
import {Block} from './blocks/block'
import {OctoUtils} from './octoUtils'
import {Category} from './store/sidebar'

// These are outgoing commands to the server
type WSCommand = {
    action: string
    workspaceId?: string
    readToken?: string
    blockIds?: string[]
}

// These are messages from the server
export type WSMessage = {
    action?: string
    block?: Block
    category?: Category
    error?: string
}

export const ACTION_UPDATE_BLOCK = 'UPDATE_BLOCK'
export const ACTION_AUTH = 'AUTH'
export const ACTION_SUBSCRIBE_BLOCKS = 'SUBSCRIBE_BLOCKS'
export const ACTION_SUBSCRIBE_WORKSPACE = 'SUBSCRIBE_WORKSPACE'
export const ACTION_UNSUBSCRIBE_WORKSPACE = 'UNSUBSCRIBE_WORKSPACE'
export const ACTION_UNSUBSCRIBE_BLOCKS = 'UNSUBSCRIBE_BLOCKS'
export const ACTION_UPDATE_CLIENT_CONFIG = 'UPDATE_CLIENT_CONFIG'
export const ACTION_UPDATE_CATEGORY = 'UPDATE_CATEGORY'

// The Mattermost websocket client interface
export interface MMWebSocketClient {
    conn: WebSocket | null;
    sendMessage(action: string, data: any, responseCallback?: () => void): void /* eslint-disable-line @typescript-eslint/no-explicit-any */
    setFirstConnectCallback(callback: () => void): void
    setReconnectCallback(callback: () => void): void
    setErrorCallback(callback: (event: Event) => void): void
    setCloseCallback(callback: (connectFailCount: number) => void): void
}

type OnChangeHandler = (client: WSClient, items: any[]) => void
type OnReconnectHandler = (client: WSClient) => void
type OnStateChangeHandler = (client: WSClient, state: 'init' | 'open' | 'close') => void
type OnErrorHandler = (client: WSClient, e: Event) => void
type OnConfigChangeHandler = (client: WSClient, clientConfig: ClientConfig) => void

export type ChangeHandlerType = 'block' | 'category'

type UpdatedData = {
    Blocks: Block[]
    Categories: Category[]
}

type ChangeHandlers = {
    Block: OnChangeHandler[]
    Category: OnChangeHandler[]
}

class WSClient {
    ws: WebSocket|null = null
    client: MMWebSocketClient|null = null
    onPluginReconnect: null|(() => void) = null
    pluginId = ''
    pluginVersion = ''
    onAppVersionChangeHandler: ((versionHasChanged: boolean) => void) | null = null
    clientPrefix = ''
    serverUrl: string | undefined
    state: 'init'|'open'|'close' = 'init'
    onStateChange: OnStateChangeHandler[] = []
    onReconnect: OnReconnectHandler[] = []
    onChange: ChangeHandlers = {Block: [], Category: []}
    onError: OnErrorHandler[] = []
    onConfigChange: OnConfigChangeHandler[] = []
    private notificationDelay = 100
    private reopenDelay = 3000
    private updatedData: UpdatedData = {Blocks: [], Categories: []}
    private updateTimeout?: NodeJS.Timeout
    private errorPollId?: NodeJS.Timeout

    private logged = false

    // this need to be a function rather than a const because
    // one of the global variable (`window.baseURL`) is set at runtime
    // after the first instance of OctoClient is created.
    // Avoiding the race condition becomes more complex than making
    // the base URL dynamic though a function
    private getBaseURL(): string {
        const baseURL = (this.serverUrl || Utils.getBaseURL(true)).replace(/\/$/, '')

        // Logging this for debugging.
        // Logging just once to avoid log noise.
        if (!this.logged) {
            Utils.log(`WSClient serverUrl: ${baseURL}`)
            this.logged = true
        }

        return baseURL
    }

    constructor(serverUrl?: string) {
        this.serverUrl = serverUrl
    }

    initPlugin(pluginId: string, pluginVersion: string, client: MMWebSocketClient): void {
        this.pluginId = pluginId
        this.pluginVersion = pluginVersion
        this.clientPrefix = `custom_${pluginId}_`
        this.client = client
        Utils.log(`WSClient initialised for plugin id "${pluginId}"`)
    }

    sendCommand(command: WSCommand): void {
        if (this.client !== null) {
            const {action, ...data} = command
            this.client.sendMessage(this.clientPrefix + action, data)
            return
        }

        this.ws?.send(JSON.stringify(command))
    }

    addOnChange(handler: OnChangeHandler, type: ChangeHandlerType): void {
        if (type === 'block') {
            this.onChange.Block.push(handler)
        } else if (type === 'category') {
            this.onChange.Category.push(handler)
        }
    }

    removeOnChange(handler: OnChangeHandler, type: ChangeHandlerType): void {
        if (type === 'block') {
            const index = this.onChange.Block.indexOf(handler)
            if (index !== -1) {
                this.onChange.Block.splice(index, 1)
            }
        } else if (type === 'category') {
            const index = this.onChange.Category.indexOf(handler)
            if (index !== -1) {
                this.onChange.Category.splice(index, 1)
            }
        }
    }

    addOnReconnect(handler: OnReconnectHandler): void {
        this.onReconnect.push(handler)
    }

    removeOnReconnect(handler: OnReconnectHandler): void {
        const index = this.onReconnect.indexOf(handler)
        if (index !== -1) {
            this.onReconnect.splice(index, 1)
        }
    }

    addOnStateChange(handler: OnStateChangeHandler): void {
        this.onStateChange.push(handler)
    }

    removeOnStateChange(handler: OnStateChangeHandler): void {
        const index = this.onStateChange.indexOf(handler)
        if (index !== -1) {
            this.onStateChange.splice(index, 1)
        }
    }

    addOnError(handler: OnErrorHandler): void {
        this.onError.push(handler)
    }

    removeOnError(handler: OnErrorHandler): void {
        const index = this.onError.indexOf(handler)
        if (index !== -1) {
            this.onError.splice(index, 1)
        }
    }

    addOnConfigChange(handler: OnConfigChangeHandler): void {
        this.onConfigChange.push(handler)
    }

    removeOnConfigChange(handler: OnConfigChangeHandler): void {
        const index = this.onConfigChange.indexOf(handler)
        if (index !== -1) {
            this.onConfigChange.splice(index, 1)
        }
    }

    open(): void {
        if (this.client !== null) {
            // configure the Mattermost websocket client callbacks
            const onConnect = () => {
                Utils.log('WSClient in plugin mode, reusing Mattermost WS connection')

                for (const handler of this.onStateChange) {
                    handler(this, 'open')
                }
                this.state = 'open'
            }

            const onReconnect = () => {
                Utils.logWarn('WSClient reconnected')

                onConnect()
                for (const handler of this.onReconnect) {
                    handler(this)
                }
            }
            this.onPluginReconnect = onReconnect

            const onClose = (connectFailCount: number) => {
                Utils.logError(`WSClient has been closed, connect fail count: ${connectFailCount}`)

                for (const handler of this.onStateChange) {
                    handler(this, 'close')
                }
                this.state = 'close'

                // there is no way to react to a reconnection with the
                // reliable websockets schema, so we poll the raw
                // websockets client for its state directly until it
                // reconnects
                if (!this.errorPollId) {
                    this.errorPollId = setInterval(() => {
                        Utils.logWarn(`Polling websockets connection for state: ${this.client?.conn?.readyState}`)
                        if (this.client?.conn?.readyState === 1) {
                            onReconnect()
                            clearInterval(this.errorPollId!)
                            this.errorPollId = undefined
                        }
                    }, 500)
                }
            }

            const onError = (event: Event) => {
                Utils.logError(`WSClient websocket onerror. data: ${JSON.stringify(event)}`)

                for (const handler of this.onError) {
                    handler(this, event)
                }
            }

            this.client.setFirstConnectCallback(onConnect)
            this.client.setErrorCallback(onError)
            this.client.setCloseCallback(onClose)
            this.client.setReconnectCallback(onReconnect)

            return
        }

        const url = new URL(this.getBaseURL())
        const protocol = (url.protocol === 'https:') ? 'wss:' : 'ws:'
        const wsServerUrl = `${protocol}//${url.host}${url.pathname.replace(/\/$/, '')}/ws`
        Utils.log(`WSClient open: ${wsServerUrl}`)
        const ws = new WebSocket(wsServerUrl)
        this.ws = ws

        ws.onopen = () => {
            Utils.log('WSClient webSocket opened.')
            for (const handler of this.onStateChange) {
                handler(this, 'open')
            }
            this.state = 'open'
        }

        ws.onerror = (e) => {
            Utils.logError(`WSClient websocket onerror. data: ${e}`)
            for (const handler of this.onError) {
                handler(this, e)
            }
        }

        ws.onclose = (e) => {
            Utils.log(`WSClient websocket onclose, code: ${e.code}, reason: ${e.reason}`)
            if (ws === this.ws) {
                // Unexpected close, re-open
                Utils.logError('Unexpected close, re-opening websocket')
                for (const handler of this.onStateChange) {
                    handler(this, 'close')
                }
                this.state = 'close'
                setTimeout(() => {
                    this.open()
                    for (const handler of this.onReconnect) {
                        handler(this)
                    }
                }, this.reopenDelay)
            }
        }

        ws.onmessage = (e) => {
            if (ws !== this.ws) {
                Utils.log('Ignoring closed ws')
                return
            }

            try {
                const message = JSON.parse(e.data) as WSMessage
                if (message.error) {
                    Utils.logError(`Listener websocket error: ${message.error}`)
                    return
                }

                switch (message.action) {
                case ACTION_UPDATE_BLOCK:
                    this.updateHandler(message)
                    break
                case ACTION_UPDATE_CATEGORY:
                    this.updateHandler(message)
                    break
                default:
                    Utils.logError(`Unexpected action: ${message.action}`)
                }
            } catch (err) {
                Utils.log('message is not an object')
            }
        }
    }

    hasConn(): boolean {
        return this.ws !== null || this.client !== null
    }

    updateHandler(message: WSMessage): void {
        const [data, type] = Utils.fixWSData(message)
        if (data) {
            this.queueUpdateNotification(data, type)
        }
    }

    updateClientConfigHandler(config: ClientConfig): void {
        for (const handler of this.onConfigChange) {
            handler(this, config)
        }
    }

    setOnAppVersionChangeHandler(fn: (versionHasChanged: boolean) => void): void {
        this.onAppVersionChangeHandler = fn
    }

    pluginStatusesChangedHandler(data: any): void {
        if (this.pluginId === '' || !this.onAppVersionChangeHandler) {
            return
        }

        const focalboardStatusChange = data.plugin_statuses.find((s: any) => s.plugin_id === this.pluginId)
        if (focalboardStatusChange) {
            // if the plugin version is greater than the current one,
            // show the new version banner
            if (Utils.compareVersions(this.pluginVersion, focalboardStatusChange.version) > 0) {
                Utils.log('Boards plugin has been updated')
                this.onAppVersionChangeHandler(true)
            }

            // if the plugin version is greater or equal, trigger a
            // reconnect to resubscribe in case the interface hasn't
            // been reloaded
            if (Utils.compareVersions(this.pluginVersion, focalboardStatusChange.version) >= 0) {
                // this is a temporal solution that leaves a second
                // between the message and the reconnect so the server
                // has time to register the WS handler
                setTimeout(() => {
                    if (this.onPluginReconnect) {
                        Utils.log('Reconnecting after plugin update')
                        this.onPluginReconnect()
                    }
                }, 1000)
            }
        }
    }

    authenticate(workspaceId: string, token: string): void {
        if (!this.hasConn()) {
            Utils.assertFailure('WSClient.addBlocks: ws is not open')
            return
        }

        if (!token) {
            return
        }
        const command = {
            action: ACTION_AUTH,
            token,
            workspaceId,
        }

        this.sendCommand(command)
    }

    subscribeToBlocks(workspaceId: string, blockIds: string[], readToken = ''): void {
        if (!this.hasConn()) {
            Utils.assertFailure('WSClient.subscribeToBlocks: ws is not open')
            return
        }

        const command: WSCommand = {
            action: ACTION_SUBSCRIBE_BLOCKS,
            blockIds,
            workspaceId,
            readToken,
        }

        this.sendCommand(command)
    }

    unsubscribeToWorkspace(workspaceId: string): void {
        if (!this.hasConn()) {
            Utils.assertFailure('WSClient.subscribeToWorkspace: ws is not open')
            return
        }

        const command: WSCommand = {
            action: ACTION_UNSUBSCRIBE_WORKSPACE,
            workspaceId,
        }

        this.sendCommand(command)
    }

    subscribeToWorkspace(workspaceId: string): void {
        if (!this.hasConn()) {
            Utils.assertFailure('WSClient.subscribeToWorkspace: ws is not open')
            return
        }

        const command: WSCommand = {
            action: ACTION_SUBSCRIBE_WORKSPACE,
            workspaceId,
        }

        this.sendCommand(command)
    }

    unsubscribeFromBlocks(workspaceId: string, blockIds: string[], readToken = ''): void {
        if (!this.hasConn()) {
            Utils.assertFailure('WSClient.removeBlocks: ws is not open')
            return
        }

        const command: WSCommand = {
            action: ACTION_UNSUBSCRIBE_BLOCKS,
            blockIds,
            workspaceId,
            readToken,
        }

        this.sendCommand(command)
    }

    private queueUpdateNotification(data: Block | Category, type: ChangeHandlerType) {
        // Remove existing queued update
        if (type === 'block') {
            this.updatedData.Blocks = this.updatedData.Blocks.filter((o) => o.id !== data.id)
            this.updatedData.Blocks.push(OctoUtils.hydrateBlock(data as Block))
        } else if (type === 'category') {
            this.updatedData.Categories = this.updatedData.Categories.filter((c) => c.id !== data.id)
            this.updatedData.Categories.push(data as Category)
        }

        if (this.updateTimeout) {
            clearTimeout(this.updateTimeout)
            this.updateTimeout = undefined
        }

        this.updateTimeout = setTimeout(() => {
            this.flushUpdateNotifications()
        }, this.notificationDelay)
    }

    private flushUpdateNotifications() {
        for (const block of this.updatedData.Blocks) {
            Utils.log(`WSClient flush update block: ${block.id}`)
        }

        for (const category of this.updatedData.Categories) {
            Utils.log(`WSClient flush update category: ${category.id}`)
        }

        for (const handler of this.onChange.Block) {
            handler(this, this.updatedData.Blocks)
        }

        for (const handler of this.onChange.Category) {
            handler(this, this.updatedData.Categories)
        }

        this.updatedData = {
            Blocks: [],
            Categories: [],
        }
    }

    close(): void {
        if (!this.hasConn()) {
            return
        }

        Utils.log(`WSClient close: ${this.ws?.url}`)

        // Use this sequence so the onclose method doesn't try to re-open
        const ws = this.ws
        this.ws = null
        this.onChange = {Block: [], Category: []}
        this.onReconnect = []
        this.onStateChange = []
        this.onError = []

        // if running in plugin mode, nothing else needs to be done
        if (this.client) {
            return
        }

        try {
            ws?.close()
        } catch {
            try {
                (ws as any)?.websocket?.close()
            } catch {
                Utils.log('WSClient unable to close the websocket')
            }
        }
    }
}

const wsClient = new WSClient()

export {WSClient}
export default wsClient
