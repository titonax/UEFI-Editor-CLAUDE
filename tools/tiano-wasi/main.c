#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "Decompress.h"

static unsigned char *read_file(const char *path, size_t *size) {
  FILE *file = fopen(path, "rb");
  unsigned char *data;
  long length;
  if (!file || fseek(file, 0, SEEK_END) != 0 || (length = ftell(file)) < 0 ||
      fseek(file, 0, SEEK_SET) != 0) return NULL;
  data = malloc(length ? (size_t)length : 1);
  if (!data || fread(data, 1, (size_t)length, file) != (size_t)length) {
    fclose(file);
    free(data);
    return NULL;
  }
  fclose(file);
  *size = (size_t)length;
  return data;
}

int main(int argc, char **argv) {
  unsigned char *source, *destination, *scratch;
  size_t source_size, destination_size, scratch_size;
  EFI_STATUS status;
  FILE *output;
  if (argc != 4 || (strcmp(argv[3], "tiano") != 0 && strcmp(argv[3], "efi") != 0)) {
    fprintf(stderr, "usage: tiano-decompress input.bin output.bin tiano|efi\n");
    return 2;
  }
  source = read_file(argv[1], &source_size);
  if (!source || TianoGetInfo(source, source_size, &destination_size, &scratch_size) != EFI_SUCCESS) {
    fprintf(stderr, "invalid EFI/Tiano compressed stream\n");
    return 3;
  }
  if (destination_size > 64U * 1024U * 1024U) {
    fprintf(stderr, "decompressed section exceeds the 64 MiB safety limit\n");
    return 4;
  }
  destination = malloc(destination_size ? destination_size : 1);
  scratch = malloc(scratch_size);
  if (!destination || !scratch) {
    fprintf(stderr, "cannot allocate decompression buffers\n");
    return 4;
  }
  status = strcmp(argv[3], "efi") == 0
    ? EfiDecompress(source, source_size, destination, destination_size, scratch, scratch_size)
    : TianoDecompress(source, source_size, destination, destination_size, scratch, scratch_size);
  if (status != EFI_SUCCESS) {
    fprintf(stderr, "%s decompression rejected the stream\n", argv[3]);
    return 5;
  }
  output = fopen(argv[2], "wb");
  if (!output || fwrite(destination, 1, destination_size, output) != destination_size) {
    fprintf(stderr, "cannot write decompressed output\n");
    return 6;
  }
  fclose(output);
  free(source); free(destination); free(scratch);
  return 0;
}
