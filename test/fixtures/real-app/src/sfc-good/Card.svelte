<script lang="ts">
  import { addDays } from 'date-fns';
  import Good from './Good.vue';
  export let at = addDays(new Date(), 1);
</script>

<p>{at.toISOString()}</p>
<script type="application/ld+json">{ "not": "javascript" }</script>
