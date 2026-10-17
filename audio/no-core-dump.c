#include <sys/prctl.h>
#include <sys/resource.h>
#include <unistd.h>

/* A trusted LD_PRELOAD constructor runs again after each exec. RLIMIT_CORE
 * alone does not prevent piped crash handlers from capturing process memory. */
__attribute__((constructor)) static void protect_audio_memory(void) {
    const struct rlimit limit = {0, 0};
    if (setrlimit(RLIMIT_CORE, &limit) != 0 || prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) {
        _exit(125);
    }
}
