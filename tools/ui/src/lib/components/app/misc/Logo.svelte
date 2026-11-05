<script>
	import upstreamLogo from '$lib/assets/logo.svg?raw';
	import picoLogo from '$lib/assets/pico-logo.svg?raw';
	import { IS_PICO_BUILD } from '$lib/constants/app.constants';

	const logoMark = IS_PICO_BUILD ? picoLogo : upstreamLogo;
	let { class: className = '', style = '' } = $props();
</script>

<div class={className} {style}>
	{@html logoMark}
</div>

<style>
	div :global(svg) {
		width: var(--size, 1rem);
		height: var(--size, 1rem);
	}
</style>
