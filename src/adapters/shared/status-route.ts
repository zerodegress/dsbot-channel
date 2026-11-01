import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AdapterStatus } from '../../adapter-status.js'
import { hasForwardingHeaders, isLoopbackPeer } from '../../adapter-status.js'

export interface StatusRouteOptions {
  route: string
  report: () => AdapterStatus
  /** Called when a request reached the route but was refused, so the transport can count it. */
  onRefused?: (() => void) | undefined
}

function answer(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  response.end(text)
}

/** Answers a loopback-only status read; returns true when this request was the status request. */
export function answerStatus(
  request: IncomingMessage,
  response: ServerResponse,
  options: StatusRouteOptions,
): boolean {
  if (request.method !== 'GET' || request.url !== options.route) return false
  if (!isLoopbackPeer(request.socket.remoteAddress) || hasForwardingHeaders(request.headers)) {
    options.onRefused?.()
    answer(response, 404, { error: 'not found' })
    return true
  }
  answer(response, 200, options.report())
  return true
}
