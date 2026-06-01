import { source } from '@/lib/source';
import { createFromSource } from 'fumadocs-core/search/server';

// Static search index built from the docs source. Fumadocs' default search
// dialog queries this endpoint.
export const { GET } = createFromSource(source);
