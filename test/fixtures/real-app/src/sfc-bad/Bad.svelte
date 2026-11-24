<script lang="ts">
  import { formatRelativeTime } from 'date-fns';
  import * as z from 'zod';
  const email = z.string().emailAddress();
</script>

<p>{formatRelativeTime} {email}</p>
