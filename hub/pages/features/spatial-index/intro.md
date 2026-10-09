"What's near this point?" is a question games ask thousands of times a frame: which lights reach
this mesh, which enemies hear the player, which pickups are in reach. The spatial index answers
it from uniform grids without allocating, and the engine's own light culling already runs on it.
