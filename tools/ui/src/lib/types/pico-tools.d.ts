import type { MCPResourceIcon } from './mcp';

/** One tool of Pico's `/mcp` `tools/list`; `approvalRequired` is Pico's `_meta["pico/approval"]` decision for this caller. */
export interface PicoToolInfo {
	name: string;
	title?: string;
	description?: string;
	icons?: MCPResourceIcon[];
	inputSchema?: Record<string, unknown>;
	readOnly?: boolean;
	approvalRequired: boolean;
}

/** The Responses `mcp` tool entry the WebUI sends for Pico. */
export interface ResponsesMcpTool {
	type: 'mcp';
	server_label: string;
	server_url: string;
	allowed_tools: string[];
	require_approval?: { never: { tool_names: string[] } };
}

/** OpenAI's `McpToolCallError` union; older servers send a plain string. */
export type ResponsesMcpCallError =
	| string
	| { type: 'mcp_protocol_error' | 'http_error'; code?: number; message?: string }
	| { type: 'mcp_tool_execution_error'; content?: unknown };

/** OpenAI Responses MCP items, as received in `output` and sent back in `input`. */
export type ResponsesMcpWireItem =
	| {
			type: 'mcp_list_tools';
			id: string;
			server_label: string;
			tools: Array<{
				name: string;
				input_schema: unknown;
				description?: string | null;
				annotations?: unknown;
			}>;
			error?: string | null;
	  }
	| {
			type: 'mcp_call';
			id: string;
			server_label: string;
			name: string;
			arguments: string;
			approval_request_id?: string | null;
			error?: ResponsesMcpCallError | null;
			output?: string | null;
			status?: 'in_progress' | 'completed' | 'incomplete' | 'calling' | 'failed';
	  }
	| {
			type: 'mcp_approval_request';
			id: string;
			server_label: string;
			name: string;
			arguments: string;
	  }
	| {
			type: 'mcp_approval_response';
			approval_request_id: string;
			approve: boolean;
			id?: string | null;
			reason?: string | null;
	  };

/**
 * A stored MCP item.
 * `content_offset` is the WebUI's own field: the length of the text streamed before the item, so history keeps the model's order; it is never sent.
 */
export type ResponsesMcpItem = ResponsesMcpWireItem & { content_offset?: number };

export type ResponsesMcpCallItem = Extract<ResponsesMcpItem, { type: 'mcp_call' }>;
export type ResponsesMcpApprovalRequestItem = Extract<
	ResponsesMcpItem,
	{ type: 'mcp_approval_request' }
>;
