(= (observe-audio $audio_id)
   (py-call (audio.observe_audio $audio_id)))

(= (inspect-audio $audio_id $question)
   (py-call (audio.inspect_audio $audio_id $question)))

(= (audio-observation-log $count)
   (py-call (audio.recent_audio_observations $count)))
