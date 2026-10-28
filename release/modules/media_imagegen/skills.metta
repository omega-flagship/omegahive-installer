(= (generate-image $prompt)
   (py-call (imagegen.generate_image $prompt)))

(= (generate-image-quality $prompt)
   (py-call (imagegen.generate_image_quality $prompt)))
