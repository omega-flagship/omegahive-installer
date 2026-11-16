; hello-greet: pure MeTTa, no state, no Python, no effects.
(= (hello-greet $name)
   (repr (Greeting "hello" $name)))
