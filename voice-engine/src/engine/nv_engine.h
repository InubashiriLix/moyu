#ifndef NV_ENGINE_H
#define NV_ENGINE_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct nv_session nv_session;
enum nv_state {NV_IDLE=0,NV_RUNNING=1,NV_PAUSED=2,NV_COMPLETED=3,NV_CANCELLED=4,NV_ERROR=5};
typedef struct nv_config {
    const char *models_dir,*model,*speaker,*cache_dir,*output_wav;
    int threads,playback,cache_enabled,idle_seconds;
    double preroll_seconds,max_buffer_seconds;
    int64_t seed;
} nv_config;
typedef struct nv_request {const char *text,*preceding_context,*following_context,*speaker,*instruction;int automatic;} nv_request;
/* Position follows PCM consumed by the device callback, excluding silence.
   Device/hardware output latency is not included. valid is false before audio.
   Byte offsets refer to the submitted UTF-8 text, never to generated progress. */
typedef struct nv_playback_position {
    uint64_t consumed_samples;
    size_t byte_begin,byte_end;
    int sample_rate,valid,buffering;
} nv_playback_position;
int nv_engine_abi_version(void);
nv_playback_position nv_get_playback_position(nv_session*);
typedef struct nv_metrics {
    double wall_seconds,first_pcm_seconds,load_seconds,synthesis_seconds,audio_seconds;
    size_t cache_hits,underrun_samples;
    int cold_start,cancelled;
} nv_metrics;
/* Callbacks run on the session thread; PCM is valid only during the callback.
   Copy retained samples. Do not destroy/wait/submit the same session in a callback.
   Return zero from PCM callback to stop. Progress reports generated_end and
   total_bytes in UTF-8 bytes; playback highlighting needs the audio clock.
   Callbacks must not throw exceptions across this C ABI. */
typedef int (*nv_pcm_callback)(const float*,size_t,int,void*);
typedef void (*nv_progress_callback)(size_t generated_end,size_t total_bytes,void*);
typedef void (*nv_error_callback)(const char*,void*);
nv_config nv_default_config(void);
nv_session *nv_create(const nv_config*,nv_pcm_callback,nv_progress_callback,nv_error_callback,void*);
int nv_submit(nv_session*,const nv_request*);
void nv_pause(nv_session*);
void nv_resume(nv_session*);
void nv_stop(nv_session*);
int nv_wait(nv_session*);
int nv_get_state(nv_session*);
nv_metrics nv_get_metrics(nv_session*);
const char *nv_last_error(nv_session*);
void nv_destroy(nv_session*);
#ifdef __cplusplus
}
#endif
#endif
