export interface InboundRequest {
  eventId: string
  chainId: string
  to: string
  sender: string
  instance: string
  body: string
  media?: readonly (readonly [string, string])[]
  sentAt: number
  /** The peer refused this request, so its turn runs but answers nothing. */
  status?: 'declined'
  reason?: string
  final?: boolean
  inReplyTo?: string
  inReplyToExcerpt?: string
}

