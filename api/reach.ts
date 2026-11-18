import { handleReach } from "../src/reach/handler.ts"

export default function handler(request: Request): Promise<Response> {
  return handleReach(new URL(request.url))
}
