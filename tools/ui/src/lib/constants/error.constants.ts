export const ERROR_MESSAGES = {
	CHAT_STORAGE: {
		IMPORT_UNAVAILABLE:
			"Import isn't available while chats are stored on Pico Server. Store chats in this browser to import.",
		STALE_VERSION:
			'This chat changed in another window. Refresh the page to see the latest version.'
	},
	HTTP: {
		ACCESS_DENIED: 'Access denied',
		GENERIC: 'Request failed',
		INTERNAL_ERROR: 'Server error - check server logs',
		NOT_FOUND: 'Not found',
		TEMPORARILY_UNAVAILABLE: 'Server temporarily unavailable'
	},
	NETWORK: {
		GENERIC: 'Failed to connect to server',
		NXDOMAIN: 'Server not found - check server address',
		REFUSED: 'Connection refused - server may be offline',
		TIMEOUT: 'Request timed out',
		UNREACHABLE: 'Server is not running or unreachable'
	}
};

export const HTTP_CODE_TO_STRING: Record<string, string> = {
	401: ERROR_MESSAGES.HTTP.ACCESS_DENIED,
	403: ERROR_MESSAGES.HTTP.ACCESS_DENIED,
	500: ERROR_MESSAGES.HTTP.INTERNAL_ERROR,
	503: ERROR_MESSAGES.HTTP.TEMPORARILY_UNAVAILABLE
};
