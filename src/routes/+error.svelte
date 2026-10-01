<script lang="ts">
	import { page } from '$app/state';
</script>

<div class="hud-cover">
	<div class="hud-globe"></div>
	<div class="hud-auth">
		<div class="hud-kicker">Error {page.status}</div>
		<h1>{page.error?.message || 'Something broke'}</h1>
		<a class="btn-hud d-inline-block mt-3" href="/">Back</a>
	</div>
</div>
