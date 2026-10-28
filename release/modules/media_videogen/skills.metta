(= (generate-video $prompt)
   (py-call (videogen.generate_video $prompt)))

(= (video-config-status)
   (py-call (videogen.validate_video_config)))
