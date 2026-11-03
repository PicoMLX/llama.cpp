import type { PicoCardKind } from './types';
import { t } from '$lib/i18n';

export const PICO_CARD_NAMES: Record<PicoCardKind, string> = {
	'html-preview': 'HTML',
	openui: 'OpenUI',
	'vega-lite': 'Vega-Lite'
};

export function getPicoCardLabels(kind: PicoCardKind) {
	return {
		closePreview: t('pico.card.close_preview'),
		copy: t('pico.card.copy'),
		copyFailed: t('pico.card.copy_failed'),
		copySuccess: t('pico.card.copy_success'),
		expand: t('pico.card.expand'),
		preparing: t('pico.card.preparing'),
		preview: t('pico.card.preview_label', { name: PICO_CARD_NAMES[kind] }),
		showCode: t('pico.card.show_code'),
		showPreview: t('pico.card.show_preview'),
		unavailable: t('pico.card.unavailable')
	};
}
