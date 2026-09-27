import { emptyState, transition, WorkspaceError, type Command, type WorkspaceState } from './state'

/** One bounded beta registry. It is accessible only through the Worker binding;
 * there is deliberately no public WebSocket or user-supplied room identifier.
 */
export class WorkspaceRoom {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response(null, { status: 405 })
    const command = await request.json<Command>()
    try {
      const result = await this.state.storage.transaction(async (storage) => {
        const data = await storage.get<WorkspaceState>('workspace-v1') ?? emptyState()
        const output = transition(data, command)
        await storage.put('workspace-v1', data)
        return output
      })
      return Response.json(result)
    } catch (error) {
      if (error instanceof WorkspaceError) return Response.json({ error: error.code }, { status: error.status })
      throw error
    }
  }
}
