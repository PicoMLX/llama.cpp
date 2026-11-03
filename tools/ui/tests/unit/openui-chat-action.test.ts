import { isOpenUIUserAction, normalizeOpenUIAction } from '$lib/pico-cards/renderers/openui/action';
import type { OpenUICardActionEnvironment } from '$lib/pico-cards/renderers/openui/chat-action';
import {
	dispatchOpenUICardAction,
	formatOpenUIContinuation,
	openUICardURL
} from '$lib/pico-cards/renderers/openui/chat-action';
import { describe, expect, it, vi } from 'vitest';

function environment(overrides: Partial<OpenUICardActionEnvironment> = {}) {
	return {
		activeConversationId: 'conversation-a',
		conversationId: 'conversation-a',
		openURL: vi.fn((_url: string) => {}),
		sendMessage: vi.fn(async (_content: string) => {}),
		streaming: false,
		userActivation: true,
		...overrides
	};
}

const continuation = {
	formName: 'trip',
	formState: { trip: { dates: { value: ['Friday', 'Sunday'] }, traveler: { value: 'Ada' } } },
	humanFriendlyMessage: '  Plan my weekend  ',
	params: { context: { flexible: false, itineraryId: 'TRIP-042', travelers: 2 } },
	type: 'continue_conversation'
};

function userAction(value: unknown) {
	const action = normalizeOpenUIAction(value, true);

	if (!action) throw new Error('Invalid test action');

	return action;
}

describe('OpenUI conversation messages', () => {
	it('preserves typed context and scoped form data with the human request', () => {
		const message = formatOpenUIContinuation(continuation)!;

		expect(message.startsWith('Plan my weekend\n')).toBe(true);
		const json = message.split('```json\n')[1].split('\n```')[0];

		expect(JSON.parse(json)).toEqual({
			context: continuation.params.context,
			formName: continuation.formName,
			formState: continuation.formState
		});
	});

	it('keeps a plain continuation plain and rejects empty or unsupported commands', () => {
		expect(
			formatOpenUIContinuation({
				humanFriendlyMessage: ' Continue ',
				type: 'continue_conversation'
			})
		).toBe('Continue');
		expect(formatOpenUIContinuation({ ...continuation, humanFriendlyMessage: ' \n ' })).toBeNull();
		expect(formatOpenUIContinuation({ ...continuation, type: 'run_javascript' })).toBeNull();
	});

	it('distinguishes stock card selections with the same visible title', () => {
		const selections = ['itinerary-a', 'itinerary-b'].map((itemId, itemIndex) => ({
			humanFriendlyMessage: 'Weekend getaway',
			params: {
				context: { viewId: 'itinerary-picker' },
				itemBody: itemIndex === 0 ? 'City museums' : 'Mountain trails',
				itemId,
				itemIndex,
				itemTitle: 'Weekend getaway'
			},
			type: 'continue_conversation'
		}));
		const messages = selections.map((selection) => formatOpenUIContinuation(selection)!);

		expect(messages[0]).not.toBe(messages[1]);

		for (const [index, message] of messages.entries()) {
			const { context, ...params } = selections[index].params;
			const json = message.split('```json\n')[1].split('\n```')[0];

			expect(JSON.parse(json)).toEqual({ context, params });
		}
	});

	it('rejects oversized or unsafe continuation parameters', () => {
		for (const params of [{ itemBody: 'x'.repeat(100_001) }, { constructor: { selected: true } }]) {
			expect(formatOpenUIContinuation({ ...continuation, params })).toBeNull();
		}
	});

	it('sends exactly one formatted request to the matching idle conversation', async () => {
		const target = environment();

		expect(await dispatchOpenUICardAction(userAction(continuation), target)).toBe(true);
		expect(target.sendMessage).toHaveBeenCalledExactlyOnceWith(
			formatOpenUIContinuation(continuation)
		);
		expect(target.openURL).not.toHaveBeenCalled();
	});

	it.each([null, 'conversation-b'])(
		'ignores a card from a different or closed conversation (%s)',
		async (activeConversationId) => {
			const target = environment({ activeConversationId });

			expect(await dispatchOpenUICardAction(userAction(continuation), target)).toBe(false);
			expect(target.sendMessage).not.toHaveBeenCalled();
		}
	);

	it('does not queue or steer an action during generation', async () => {
		const target = environment({ streaming: true });

		expect(await dispatchOpenUICardAction(userAction(continuation), target)).toBe(false);
		expect(target.sendMessage).not.toHaveBeenCalled();
	});

	it('does not trust action payload fields as proof of a user gesture', async () => {
		const forged = normalizeOpenUIAction({ ...continuation, userInitiated: true });
		const target = environment();

		expect(isOpenUIUserAction(forged)).toBe(false);
		expect(await dispatchOpenUICardAction(forged, target)).toBe(false);
		expect(target.sendMessage).not.toHaveBeenCalled();
	});
});

describe('OpenUI external links', () => {
	it.each([
		'javascript:alert(1)',
		'data:text/html,test',
		'file:///tmp/test',
		'/relative',
		'not a URL'
	])('rejects %s', (url) => {
		expect(openUICardURL({ params: { url }, type: 'open_url' })).toBeNull();
	});

	it.each([undefined, 42, { href: 'https://example.com/' }])(
		'rejects missing or non-text link targets (%s)',
		(url) => {
			expect(openUICardURL({ params: { url }, type: 'open_url' })).toBeNull();
		}
	);

	it.each(['http://example.com/', 'https://example.com/docs?section=cards'])(
		'accepts absolute web URLs (%s)',
		(url) => {
			expect(openUICardURL({ params: { url }, type: 'open_url' })).toBe(url);
		}
	);

	it('opens a requested link only with a verified action and active browser gesture', async () => {
		const raw = { params: { url: 'https://example.com/docs' }, type: 'open_url' };
		const target = environment();

		expect(
			await dispatchOpenUICardAction(normalizeOpenUIAction({ ...raw, userInitiated: true }), target)
		).toBe(false);
		expect(
			await dispatchOpenUICardAction(
				userAction(raw),
				environment({ openURL: target.openURL, userActivation: false })
			)
		).toBe(false);
		expect(target.openURL).not.toHaveBeenCalled();
		expect(await dispatchOpenUICardAction(userAction(raw), target)).toBe(true);
		expect(target.openURL).toHaveBeenCalledExactlyOnceWith('https://example.com/docs');
		expect(target.sendMessage).not.toHaveBeenCalled();
	});
});
