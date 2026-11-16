(= (webcam-status)
   (py-call (webcam.webcam_status)))

(= (capture-webcam $camera)
   (py-call (webcam.capture_webcam $camera)))

(= (inspect-webcam $question)
   (py-call (webcam.inspect_webcam $question)))

(= (webcam-observation-log $count)
   (py-call (webcam.recent_webcam_observations $count)))
