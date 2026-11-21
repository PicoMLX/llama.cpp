/** A named sidebar section the user sorts chats into. */
export interface Group {
	createdAt: number;
	id: string;
	name: string;
	updatedAt: number;
	/** Pico Server's version of the record, changed by renames; unset in this browser's database */
	version?: number;
}
