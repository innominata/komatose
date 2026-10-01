<script lang="ts">
  import Workflow from "$lib/components/Workflow.svelte";

  let { data } = $props();
</script>

{#key data.episode.id}
  <Workflow
    series={data.series}
    episode={data.episode}
    user={data.user}
    canEdit={data.canEdit}
    canUpload={data.canUpload}
    canClean={data.canClean}
    canRebuild={data.canRebuild}
    engines={data.engines}
  />
{/key}
