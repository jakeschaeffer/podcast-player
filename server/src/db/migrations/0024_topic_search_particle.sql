-- How many times a topic search's Exa run called Particle's podcast index (adapters/exa.ts); 0 means the agent
-- answered from web search alone. NULL for searches before this was recorded, and while running.
ALTER TABLE topic_search ADD COLUMN podcast_index_calls INTEGER;
