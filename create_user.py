from db import users, hash_password

def create_user(username, password, role="user"):
    users.insert_one({
        "username": username,
        "password": hash_password(password),
        "role": role
    })
    print("User created:", username)

create_user("admin", "password", "admin")
create_user("operator", "op123")
