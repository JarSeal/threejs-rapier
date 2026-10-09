A PNG or JPEG is decoded to raw pixels on the GPU, so a 2048² texture costs about 22 MB of GPU
memory, whatever its file size. Ækasha's asset pipeline encodes your textures to KTX2 at build
time, which stays block-compressed on the GPU: on this repo's test assets, texture memory went
from 85 MB to 21 MB at the same resolutions, with no visible difference. Models get compressed
geometry. You write the asset JSON as usual; the pipeline does the rest, and the outputs are
committed, so nobody else needs the encoder.
