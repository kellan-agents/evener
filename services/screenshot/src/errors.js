export class WebsnapError extends Error {
  constructor(code, status, detail = null) {
    super(`${status} ${code}`)
    this.name = 'WebsnapError'
    this.code = code
    this.status = status
    this.detail = detail
  }
}
