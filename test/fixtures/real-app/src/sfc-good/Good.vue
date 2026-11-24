<template>
  <div>{{ when }} <Child /></div>
</template>

<script setup lang="ts">
import { formatDistanceToNow } from 'date-fns';
import * as z from 'zod';
import Child from './Child.vue';

const when = formatDistanceToNow(new Date());
export const schema = z.string().min(1);
</script>
