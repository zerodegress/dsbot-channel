/** `[type, url]`, with a file's name appended when the sender gave one. */
export type P2PMediaItem = readonly [type: string, url: string, name?: string]

export interface InboundRequest {
  eventId: string
  chainId: string
  to: string
  sender: string
  instance: string
  body: string
  media?: readonly P2PMediaItem[]
  sentAt: number
  /** The peer refused this request, so its turn runs but answers nothing. */
  status?: 'declined'
  reason?: string
  final?: boolean
  inReplyTo?: string
  inReplyToExcerpt?: string
}

