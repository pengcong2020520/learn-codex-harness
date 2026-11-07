#include <signal.h>
#include <stdio.h>
#include <unistd.h>

/* A native CLI stand-in that survives its Node wrapper and ignores SIGTERM. */
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  signal(SIGTERM, SIG_IGN);
  FILE *file = fopen(argv[1], "w");
  if (!file) return 3;
  fprintf(file, "%d", getpid());
  fclose(file);
  for (;;) pause();
}
