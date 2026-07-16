package com.example.service;

public class UserServiceImpl implements UserService {
    @Override
    public String find(Long id) {
        return "user-" + id;
    }
}
