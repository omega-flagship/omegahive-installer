(= (observe-image $image_id)
   (py-call (vision.observe_image $image_id)))

(= (inspect-image $image_id $question)
   (py-call (vision.inspect_image $image_id $question)))

(= (media-observation-log $count)
   (py-call (vision.recent_media_observations $count)))
